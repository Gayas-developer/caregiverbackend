-- Add optional profile image URL for user profile editing
ALTER TABLE "User"
ADD COLUMN "avatarUrl" TEXT;
