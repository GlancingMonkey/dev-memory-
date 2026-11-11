import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.llm import LLMResponseError, generate_answer, generate_answer_stream


class LLMClientTests(unittest.TestCase):
    def test_generation_uses_one_structured_call_and_provider_usage(self):
        response = SimpleNamespace(
            status="completed",
            output_text=json.dumps(
                {
                    "status": "answered",
                    "answer": "두 수를 더합니다. [S1]",
                    "citation_ids": ["S1"],
                }
            ),
            model="gpt-6.1-sol-2026-09-29",
            usage=SimpleNamespace(
                input_tokens=100,
                output_tokens=25,
                total_tokens=125,
            ),
        )
        client = SimpleNamespace(
            responses=SimpleNamespace(
                create=unittest.mock.Mock(return_value=response)
            )
        )

        with patch("backend.llm._client", return_value=client):
            answer, model, usage = generate_answer(
                messages=[{"role": "user", "content": "무엇을 하나요?"}],
                deadline=10**20,
            )

        client.responses.create.assert_called_once()
        request = client.responses.create.call_args.kwargs
        self.assertEqual(request["model"], "gpt-6.1-sol")
        self.assertEqual(request["max_output_tokens"], 4096)
        self.assertTrue(request["text"]["format"]["strict"])
        self.assertEqual(answer.citation_ids, ["S1"])
        self.assertEqual(model, "gpt-6.1-sol-2026-09-29")
        self.assertEqual(usage, {
            "input_tokens": 100,
            "output_tokens": 25,
            "total_tokens": 125,
        })

    def test_inconsistent_provider_usage_is_rejected(self):
        response = SimpleNamespace(
            status="completed",
            output_text=json.dumps(
                {
                    "status": "answered",
                    "answer": "두 수를 더합니다. [S1]",
                    "citation_ids": ["S1"],
                }
            ),
            model="gpt-6.1-sol",
            usage=SimpleNamespace(
                input_tokens=100,
                output_tokens=25,
                total_tokens=126,
            ),
        )
        client = SimpleNamespace(
            responses=SimpleNamespace(
                create=unittest.mock.Mock(return_value=response)
            )
        )

        with patch("backend.llm._client", return_value=client):
            with self.assertRaises(LLMResponseError):
                generate_answer(
                    messages=[{"role": "user", "content": "무엇을 하나요?"}],
                    deadline=10**20,
                )

        client.responses.create.assert_called_once()

    def test_structured_response_stream_emits_only_decoded_answer_text(self):
        model_answer = {
            "status": "answered",
            "answer": "첫 줄\n두 번째 [S1]",
            "citation_ids": ["S1"],
        }
        output_text = json.dumps(model_answer, ensure_ascii=False)
        events = [
            SimpleNamespace(type="response.output_text.delta", delta=char)
            for char in output_text
        ]
        response = SimpleNamespace(
            status="completed",
            output_text=output_text,
            model="gpt-6.1-sol",
            usage=SimpleNamespace(
                input_tokens=100,
                output_tokens=25,
                total_tokens=125,
            ),
        )
        events.append(SimpleNamespace(type="response.completed", response=response))
        client = SimpleNamespace(
            responses=SimpleNamespace(create=unittest.mock.Mock(return_value=events))
        )

        with patch("backend.llm._client", return_value=client):
            chunks = list(generate_answer_stream(
                messages=[{"role": "user", "content": "설명해줘"}],
                deadline=10**20,
            ))

        request = client.responses.create.call_args.kwargs
        self.assertTrue(request["stream"])
        deltas = [value for kind, value in chunks if kind == "delta"]
        self.assertEqual("".join(deltas), model_answer["answer"])
        complete = [value for kind, value in chunks if kind == "complete"]
        self.assertEqual(len(complete), 1)
        self.assertEqual(complete[0][0].citation_ids, ["S1"])

    def test_stream_without_completed_event_is_rejected(self):
        client = SimpleNamespace(
            responses=SimpleNamespace(
                create=unittest.mock.Mock(return_value=iter([]))
            )
        )

        with patch("backend.llm._client", return_value=client):
            with self.assertRaises(LLMResponseError):
                list(generate_answer_stream(
                    messages=[{"role": "user", "content": "설명해줘"}],
                    deadline=10**20,
                ))


if __name__ == "__main__":
    unittest.main()
