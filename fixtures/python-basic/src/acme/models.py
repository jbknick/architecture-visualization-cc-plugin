"""Plain data and a small hierarchy."""


class User:
    def __init__(self, name: str) -> None:
        self.name = name

    def display(self) -> str:
        return self.name.title()


class Admin(User):
    def display(self) -> str:
        return "admin " + super().display()

    def revoke(self) -> None:
        return None
