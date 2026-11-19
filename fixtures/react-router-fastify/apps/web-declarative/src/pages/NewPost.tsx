export function NewPost() {
  async function submit(title: string) {
    await fetch("/api/posts", { method: "POST", body: JSON.stringify({ title }) });
  }
  return <button onClick={() => submit("Hello")}>Create</button>;
}
