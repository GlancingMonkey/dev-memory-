import logging

from fastapi import APIRouter, HTTPException

from backend.database import get_filter_options
from backend.schemas.filters import FilterOptionsResponse

router = APIRouter(tags=["search"])
logger = logging.getLogger(__name__)


@router.get("/filters", response_model=FilterOptionsResponse)
def filter_options_endpoint() -> FilterOptionsResponse:
    try:
        return FilterOptionsResponse(**get_filter_options())
    except Exception as error:
        logger.error("Filter options unavailable (%s)", type(error).__name__)
        raise HTTPException(
            status_code=503,
            detail="Filter service unavailable",
        ) from None
