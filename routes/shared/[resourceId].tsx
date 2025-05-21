import { FreshContext, Handlers } from "$fresh/server.ts";
import { getFileMetadata, getFileData } from "../../services/database.ts";

export const handler: Handlers = {
  async GET(_req: Request, ctx: FreshContext) {
    const resourceId = ctx.params.resourceId;

    if (!resourceId) {
      return new Response(JSON.stringify({ error: "Resource ID is missing." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const metadata = await getFileMetadata(resourceId);

      if (!metadata) {
        return new Response(JSON.stringify({ error: "File not found." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (metadata.status !== "completed") {
        return new Response(
          JSON.stringify({
            error: `File status is '${metadata.status}', not available for download.`,
          }),
          {
            status: 403, // Forbidden or 409 Conflict / 400 Bad Request
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const fileData = await getFileData(resourceId);

      if (!fileData) {
        // This case should ideally not happen if metadata status is "completed"
        // unless there was an issue during saving or data got deleted unexpectedly.
        console.error(
          `[Shared Download] File data not found for completed resourceId: ${resourceId}`,
        );
        return new Response(
          JSON.stringify({ error: "File data not found, though metadata exists." }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const headers = new Headers();
      headers.set("Content-Type", metadata.filetype || "application/octet-stream");
      headers.set(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(metadata.filename)}"`,
      );
      // Content-Length is also good to set if not automatically handled by Deno/Fresh
      headers.set("Content-Length", metadata.size.toString());

      return new Response(fileData, {
        status: 200,
        headers: headers,
      });
    } catch (error) {
      console.error(
        `[Shared Download] Error retrieving file ${resourceId}:`,
        error,
      );
      return new Response(
        JSON.stringify({ error: "Internal server error while retrieving file." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
