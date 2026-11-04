/** The most an uploaded profile picture may weigh, in bytes: under 1 MB. */
export const PROFILE_PICTURE_MAX_BYTES = 999_999;

/** Why an upload over {@link PROFILE_PICTURE_MAX_BYTES} is refused, in the browser and on the server. */
export const PROFILE_PICTURE_TOO_HEAVY = 'The picture must weigh less than 1 MB';

/** The widest and tallest an uploaded profile picture may be, in pixels. */
export const PROFILE_PICTURE_MAX_SIDE = 1000;

/** The side of the square an uploaded picture is stored as, in pixels. */
export const PROFILE_PICTURE_STORED_SIDE = 256;

/** The image types an upload may be, as a file input's `accept` names them. */
export const PROFILE_PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';
