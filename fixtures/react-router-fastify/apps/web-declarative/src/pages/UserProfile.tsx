import { useEffect, useState } from "react";
import { useParams } from "react-router";

export function UserProfile() {
  const { userId } = useParams();
  const [name, setName] = useState("");
  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((u) => setName(u.name));
  }, [userId]);
  return <h1>{name}</h1>;
}
