from .models import Admin
from .service import Service
from .store import Store
from .util import slug


def report(store: Store, user: Admin) -> int:
    user.revoke()
    return store.count()


def describe(thing):
    return thing.name()


def main() -> None:
    service = Service()
    service.run(Admin("root"))
    print(slug("done"))


if __name__ == "__main__":
    main()
