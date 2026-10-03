import { useRef, useState } from "react";
import { avatarPhotoAccept, photoToAvatarDataUrl } from "../lib/avatar-image";

export function AvatarPhotoControl({
  photo,
  onChange,
  disabled,
}: {
  photo: string | null;
  onChange: (photo: string | null) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      onChange(await photoToAvatarDataUrl(file));
    } catch (photoError) {
      setError(photoError instanceof Error ? photoError.message : String(photoError));
    }
  }

  return (
    <div className="avatar-photo-control">
      {photo ? <img alt="Uploaded photo preview" className="avatar-photo-preview" src={photo} /> : null}
      <input
        accept={avatarPhotoAccept}
        hidden
        onChange={(event) => {
          void pick(event.target.files?.[0]);
          event.target.value = "";
        }}
        ref={input}
        type="file"
      />
      <button
        className="secondary-button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        type="button"
      >
        {photo ? "Replace photo" : "Upload photo"}
      </button>
      {photo ? (
        <button className="text-button" disabled={disabled} onClick={() => onChange(null)} type="button">
          Remove photo
        </button>
      ) : null}
      {error ? <small className="inline-error">{error}</small> : null}
    </div>
  );
}
