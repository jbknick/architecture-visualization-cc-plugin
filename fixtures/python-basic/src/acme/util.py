def slug(text: str) -> str:
    return clean(text).lower()


def clean(text: str) -> str:
    return text.strip()
