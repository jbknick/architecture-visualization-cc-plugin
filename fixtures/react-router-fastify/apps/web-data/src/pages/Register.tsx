export function Register() {
  async function submit(name: string) {
    await fetch("/api/users", { method: "POST", body: JSON.stringify({ name }) });
  }
  return <button onClick={() => submit("Ada")}>Register</button>;
}
