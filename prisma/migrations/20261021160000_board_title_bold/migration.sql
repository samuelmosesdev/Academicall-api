-- Move bold headline formatting out of the theme string into its own field.
ALTER TABLE "dashboard_slides" ADD COLUMN "titleBold" BOOLEAN NOT NULL DEFAULT false;

UPDATE "dashboard_slides"
SET "titleBold" = true
WHERE ';' || "theme" || ';' LIKE '%;bold;%';

UPDATE "dashboard_slides"
SET "theme" = split_part("theme", ';', 1)
WHERE "theme" LIKE '%;%';
