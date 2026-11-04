/** An uploaded profile picture weighs less than this many bytes (1 MB). */
export const PROFILE_PICTURE_BYTE_LIMIT = 1_000_000;

/** The widest and tallest an uploaded profile picture may be, in pixels. */
export const PROFILE_PICTURE_MAX_SIDE = 1000;

/** The side of the square an uploaded picture is stored as, in pixels. */
export const PROFILE_PICTURE_STORED_SIDE = 256;

/** The image types an upload may be, as a file input's `accept` names them. */
export const PROFILE_PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';
