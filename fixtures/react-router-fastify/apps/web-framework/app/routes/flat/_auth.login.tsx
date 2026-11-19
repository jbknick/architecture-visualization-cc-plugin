export async function action() {
  await fetch("/api/users", { method: "POST" });
  return null;
}

export default function SignIn() {
  return <h1>SignIn</h1>;
}
