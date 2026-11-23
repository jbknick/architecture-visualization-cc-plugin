from .models import User


class Store:
    def __init__(self) -> None:
        self.items: list[User] = []

    def save(self, user: User) -> int:
        self.items.append(user)
        return len(self.items)

    def count(self) -> int:
        return len(self.items)
