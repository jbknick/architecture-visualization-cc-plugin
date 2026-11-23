from acme.models import User
from acme.service import Service


def test_run_saves_the_user() -> None:
    service = Service()
    assert service.run(User("ada")) > 0
