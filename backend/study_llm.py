"""One bounded JSON generation with the same request-scoped key rules as /ask."""

import json

from backend import llm


def provider_schema(value):
    """Send the shared schema subset; enforce all bounds locally afterward.

    Claude's raw JSON-schema API rejects string/numeric/most array bounds.
    Keep the constraints as descriptions, never weaken backend validation.
    """
    constraints = {"minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
                   "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "pattern", "format"}
    if isinstance(value, list):
        return [provider_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: provider_schema(item) for key, item in value.items() if key not in constraints}
    bounds = ", ".join(f"{key}={item}" for key, item in value.items() if key in constraints)
    if bounds:
        result["description"] = (result.get("description", "") + " " + bounds).strip()
    return result


def generate_study_json(*, messages, schema, deadline, session=None):
    schema = provider_schema(schema)
    try:
        if session is None or session.provider == "openai":
            client = llm._client() if session is None else session._connection()
            response = client.responses.create(
                model=llm.MODEL if session is None else session.model,
                input=messages, reasoning={"effort": "low"},
                max_output_tokens=llm.MAX_OUTPUT_TOKENS,
                text={"format": {"type": "json_schema", "name": "study_result", "strict": True, "schema": schema}},
                store=False, timeout=llm._remaining(deadline),
            )
            if response.status != "completed" or not response.output_text:
                raise llm.LLMResponseError
            text = response.output_text
        else:
            payload = session._payload(messages, structured=False)
            if session.provider == "anthropic":
                payload["max_tokens"] = llm.MAX_OUTPUT_TOKENS
                payload["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
                result = session._post("messages", payload, deadline)
                if result.get("stop_reason") != "end_turn":
                    raise llm.LLMResponseError
                text = "".join(block["text"] for block in result.get("content", []) if block.get("type") == "text")
            else:
                payload["generationConfig"] = {
                    "responseMimeType": "application/json", "responseJsonSchema": schema,
                    "maxOutputTokens": llm.MAX_OUTPUT_TOKENS,
                }
                result = session._post("generateContent", payload, deadline)
                candidates = result.get("candidates", [])
                if len(candidates) != 1 or candidates[0].get("finishReason") != "STOP":
                    raise llm.LLMResponseError
                text = "".join(part["text"] for part in candidates[0].get("content", {}).get("parts", [])
                               if "text" in part and not part.get("thought"))
        llm._remaining(deadline)
        if not isinstance(text, str) or len(text) > 200_000:
            raise llm.LLMResponseError
        result = json.loads(text)
        if not isinstance(result, dict):
            raise llm.LLMResponseError
        return result
    except (llm.LLMKeyError, llm.LLMTimeoutError, llm.LLMResponseError, llm.LLMServiceError):
        raise
    except (ValueError, KeyError, TypeError, AttributeError):
        raise llm.LLMResponseError from None
    except Exception as error:
        llm._raise_provider_error(error)
