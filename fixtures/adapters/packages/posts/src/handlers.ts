type Ctx = { req: { param(name: string): string }; json(value: unknown, status?: number): Response };

export async function showPost(c: Ctx) {
  return c.json({ id: c.req.param("id") });
}
