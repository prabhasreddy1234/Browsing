from __future__ import annotations

from .models import ToolDefinition

TOOL_REGISTRY: list[ToolDefinition] = [
    ToolDefinition(
        name="web_search",
        description="Search the public web for current information, facts, or recent content.",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    ),
    ToolDefinition(
        name="fetch_webpage",
        description="Retrieve and read the content of a specific web page URL.",
        input_schema={"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
    ),
    ToolDefinition(
        name="weather",
        description="Get current or forecast weather for a location.",
        input_schema={"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]},
    ),
    ToolDefinition(
        name="calculator",
        description="Perform arithmetic or numeric calculations.",
        input_schema={"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]},
    ),
    ToolDefinition(
        name="database_search",
        description="Query a structured database or internal records.",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    ),
    ToolDefinition(
        name="file_search",
        description="Search local files, documents, or project knowledge base.",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    ),
    ToolDefinition(
        name="no_tool",
        description="No tool is needed because the request is conversational, trivial, or does not require external action.",
        input_schema={"type": "object", "properties": {}, "required": []},
    ),
]

TOOL_NAMES = {tool.name for tool in TOOL_REGISTRY}
