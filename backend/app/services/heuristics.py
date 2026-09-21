from __future__ import annotations

"""Offline tool-selection heuristic.

Used as the *mock* answer for Jev when no TYPESAFE_API_KEY is set, and as the
local fallback for the LLM baseline when no OpenAI key is set. Deliberately
crude and keyword-based — real accuracy comes from the live models.
"""


def get_local_fallback_tool(query: str) -> str:
    q = query.lower()
    if any(term in q for term in ["weather", "rain", "temperature", "forecast", "sunny", "cloudy", "humidity", "umbrella", "snow", "air quality"]):
        return "weather"
    if any(term in q for term in ["calculate", "calculator", "math", "sum", "product", "multiply", "divide", "add", "subtract", "+", "*", "-", "%", "equation", "interest", "discount", "square root"]):
        return "calculator"
    if any(term in q for term in ["http://", "https://", "url", "homepage", "read the article", "read the page", "retrieve the page", "get the contents of"]):
        return "fetch_webpage"
    if any(term in q for term in ["customer", "record", "database", "crm", "sales report", "orders", "patient", "vip account", "transaction", "query the db", "lookup user", "product logs", "internal"]):
        return "database_search"
    if any(term in q for term in ["document", "doc", "file", "readme", "notes", "my project", "repo", "in my files", "search local", "policy", "handbook", "issue tracker", "uploaded", "local notes", "config file"]):
        return "file_search"
    if any(term in q for term in ["search the web", "latest", "find information", "who is", "what is the capital", "release notes", "openai", "android", "tesla", "stock", "public information", "latest release", "current"]):
        return "web_search"
    if q.strip() == "":
        return "no_tool"
    return "no_tool"
