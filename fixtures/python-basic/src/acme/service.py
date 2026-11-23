from . import util
from .base import Base
from .models import User
from .store import Store


class Service(Base):
    def __init__(self) -> None:
        self.store = Store()

    def run(self, user: User) -> int:
        self.touch()
        self.audit()
        label = util.slug(user.display())
        return self.store.save(user) + len(label)

    def touch(self) -> None:
        self.store.count()
