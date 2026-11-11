/**
 * Documents: files the owner keeps (a contract, a receipt, a note), optionally attached to a
 * project or task. Bytes live in AppPort Services Files in this app's FeltDB instance; the
 * `documents` record says whose they are and what they are for.
 *
 * Upload is two steps so the browser never sends bytes through a function: `prepareUpload` mints a
 * single-use link with the owner fixed in its metadata, the browser PUTs the bytes to it, and
 * `attach` binds the resulting file after checking it is theirs. Downloads are short-lived links.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, documents, projects, tasks } from "./app.js";
import { me, own } from "./_ops.js";

const Doc = s.doc(documents);

export const list = app.query({
  access: "documents.read",
  args: { projectId: s.optional(s.string()), taskId: s.optional(s.string()) },
  returns: s.array(Doc),
  capability: { name: "documents.list", description: "Your saved documents (name, size, note, and the project or task each is attached to), newest first." },
  handler: (ctx, { projectId, taskId }) =>
    ctx.db.find(documents, { owner: me(ctx), ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) }, { orderBy: [{ field: "createdAt", direction: "desc" }] }),
});

export const prepareUpload = app.mutation({
  access: "documents.write",
  args: { name: s.string({ minLength: 1, maxLength: 200 }), contentType: s.optional(s.string({ maxLength: 120 })) },
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx, { name, contentType }) =>
    ctx.services.files.uploadLink({ name, ...(contentType ? { contentType } : {}), metadata: { app: "personalos", owner: me(ctx) }, maxBytes: 10 * 1024 * 1024, expiresInSeconds: 600 }),
});

export const attach = app.mutation({
  access: "documents.write",
  args: { fileId: s.string(), note: s.optional(s.string({ maxLength: 500 })), projectId: s.optional(s.string()), taskId: s.optional(s.string()) },
  returns: Doc,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { fileId, note, projectId, taskId }) => {
    const owner = me(ctx);
    const file = await ctx.services.files.get(fileId);
    // The link fixed the owner; a file someone else uploaded, or one not made for this app, is not attachable.
    if (file.owner !== owner || file.metadata.owner !== owner || file.metadata.app !== "personalos") fail("NOT_FOUND", `No file ${fileId}.`);
    if ((await ctx.db.find(documents, { fileId }))[0]) fail("FAILED_PRECONDITION", "That file is already saved.");
    if (projectId) await own(ctx, projects, projectId, "project");
    if (taskId) await own(ctx, tasks, taskId, "task");
    const id = await ctx.db.insert(documents, {
      owner, fileId, name: file.name, ...(file.contentType ? { contentType: file.contentType } : {}), size: file.size,
      ...(note ? { note } : {}), ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}), createdAt: Date.now(),
    });
    ctx.afterCommit.webhooks.emit("document.added", { documentId: id, name: file.name, size: file.size });
    return (await ctx.db.get(documents, id))!;
  },
});

export const update = app.mutation({
  access: "documents.write",
  args: { id: s.string(), note: s.optional(s.string({ maxLength: 500 })), projectId: s.optional(s.nullable(s.string())), taskId: s.optional(s.nullable(s.string())) },
  handler: async (ctx, { id, note, projectId, taskId }) => {
    await own(ctx, documents, id, "document");
    if (projectId) await own(ctx, projects, projectId, "project");
    if (taskId) await own(ctx, tasks, taskId, "task");
    await ctx.db.patch(documents, id, {
      ...(note !== undefined ? { note } : {}),
      ...(projectId !== undefined ? { projectId: projectId ?? undefined } : {}),
      ...(taskId !== undefined ? { taskId: taskId ?? undefined } : {}),
    });
  },
});

/** A short-lived download link. Authorizing the document is this function's job: holding the link is enough to download. */
export const link = app.mutation({
  access: "documents.read",
  args: { id: s.string() },
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx, { id }) => {
    const doc = await own<{ owner: string; fileId: string }>(ctx, documents, id, "document");
    return ctx.services.files.link(doc.fileId, { expiresInSeconds: 120, disposition: "attachment" });
  },
});

/** The person's own act, never the assistant's: removes the record and the stored bytes. */
export const remove = app.mutation({
  access: "documents.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const doc = await own<{ owner: string; fileId: string }>(ctx, documents, id, "document");
    await ctx.db.delete(documents, id);
    await ctx.services.files.remove(doc.fileId);
  },
});
