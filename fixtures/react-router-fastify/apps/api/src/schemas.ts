export const createPostSchema = {
  body: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
  },
};
