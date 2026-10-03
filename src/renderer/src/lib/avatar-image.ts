const outputSize = 256;
const maxSourceBytes = 10 * 1024 * 1024;
const acceptedTypes = ["image/png", "image/jpeg", "image/webp"];

export const avatarPhotoAccept = acceptedTypes.join(",");

/** Center-crops a user photo to a square and returns a small JPEG data URL. */
export async function photoToAvatarDataUrl(file: File): Promise<string> {
  if (!acceptedTypes.includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP photo.");
  if (file.size > maxSourceBytes) throw new Error("That photo is larger than 10 MB.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That image could not be read.");
  });
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      outputSize,
      outputSize,
    );
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
