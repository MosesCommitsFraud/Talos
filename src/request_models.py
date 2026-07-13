from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


# Request Models
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=50000, description="Chat message")
    session: str = Field(..., description="Session ID")
    attachments: Optional[List[str]] = Field(default=[], description="Attachment IDs")
    preset_id: Optional[str] = Field(default=None, description="Preset identifier")
    lang: Optional[str] = Field(
        default=None, description="UI language (e.g. 'de'/'en') for auto-generated titles"
    )

    @field_validator("message")
    @classmethod
    def clean_message(cls, v):
        return v.strip()


class SessionCreateRequest(BaseModel):
    name: Optional[str] = Field(default="", max_length=200, description="Session name")
    endpoint_url: str = Field(..., description="LLM endpoint URL")
    model: Optional[str] = Field(default="", description="Model ID")
    rag: Optional[bool] = Field(default=False, description="Enable RAG")


class PresetUpdateRequest(BaseModel):
    """Request model for updating custom preset configuration."""

    name: str = Field(
        "", max_length=50, description="Character display name (shown next to model name)"
    )
    enabled: bool = Field(True, description="Whether this character is active")
    temperature: float = Field(
        1.0, ge=0.0, le=2.0, description="Temperature parameter for text generation (0.0-2.0)"
    )
    max_tokens: int = Field(
        0, ge=0, le=8192, description="Maximum number of tokens to generate (0 = no limit)"
    )
    system_prompt: str = Field(
        "",
        max_length=10000,
        description="System prompt to guide assistant behavior (empty = default)",
    )
    inject_prefix: str = Field(
        "", max_length=5000, description="Text to prepend to each outgoing user message"
    )
    inject_suffix: str = Field(
        "", max_length=5000, description="Text to append to each outgoing user message"
    )


class DirectoryRequest(BaseModel):
    """Request model for directory operations."""

    directory: str = Field(..., min_length=1, max_length=500, description="Path to the directory")


# Response Models
class ErrorResponse(BaseModel):
    error: str = Field(..., description="Error code")
    message: str = Field(..., description="Error message")
    details: Optional[Dict[str, Any]] = Field(default=None, description="Additional error details")


class UploadResponse(BaseModel):
    id: str = Field(..., description="File ID")
    name: str = Field(..., description="Sanitized filename")
    mime: str = Field(..., description="MIME type")
    size: int = Field(..., description="File size in bytes")
    hash: str = Field(..., description="SHA-256 hash")
    uploaded_at: datetime = Field(..., description="Upload timestamp")
    is_duplicate: bool = Field(default=False, description="Whether file is a duplicate")


class SessionResponse(BaseModel):
    id: str = Field(..., description="Session ID")
    name: str = Field(..., description="Session name")
    model: str = Field(..., description="Model being used")
    rag: bool = Field(default=False, description="RAG enabled")
    archived: bool = Field(default=False, description="Whether session is archived")
