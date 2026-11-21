-- The site's public address.
--
-- The panel edits a *repo*, but it also shows media from the built site: shelf
-- covers and uploaded images live at /shelf/… and /images/… on the published
-- domain, not on the panel's. Without this column the panel had no way to build
-- an image URL, and every picture in the media library rendered as a broken
-- image pointing at the panel itself.
ALTER TABLE sites ADD COLUMN public_url TEXT NOT NULL DEFAULT '';
