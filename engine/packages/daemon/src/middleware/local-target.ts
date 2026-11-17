import type { Context, Next } from "hono";

const MH3_BOUNDARY_MESSAGE =
  "acting on a remote host is the MH-3 routing lane; the MH-2 read-through forwards allowlisted GET reads only";

/** This daemon serves one host. An absent or `local` selector is this daemon; any other names a
 *  remote one, which no route here reaches. */
export async function requireLocalTarget(c: Context, next: Next) {
  const hostParam = c.req.query("host");
  if (hostParam === undefined || hostParam === "" || hostParam === "local") return next();
  const path = c.req.path;
  if (c.req.method !== "GET") {
    return c.json(
      { error: "cross_host_write_refused", boundary: "MH-3", hostId: hostParam, method: c.req.method, path, message: MH3_BOUNDARY_MESSAGE },
      405,
    );
  }
  return c.json({ error: "read_through_path_not_allowed", boundary: "MH-3", hostId: hostParam, path, message: MH3_BOUNDARY_MESSAGE }, 403);
}