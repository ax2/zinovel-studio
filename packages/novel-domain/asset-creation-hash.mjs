// Host-only hashing. Keep the shared assets input validators browser-safe.
import { createHash } from "node:crypto";
import { assetId, assetInput, validateAssetBlob } from "./assets.mjs";
export function assetCreationHash(id, bookId, input, blob) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: assetId(id),
        bookId: assetId(bookId),
        input: assetInput(input),
        blob: validateAssetBlob(blob),
      }),
    )
    .digest("hex");
}
