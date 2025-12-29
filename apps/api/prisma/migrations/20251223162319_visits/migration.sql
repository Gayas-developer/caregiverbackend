/*
  Warnings:

  - Added the required column `branchId` to the `Alert` table without a default value. This is not possible if the table is not empty.
  - Added the required column `visitId` to the `Alert` table without a default value. This is not possible if the table is not empty.
  - Added the required column `branchId` to the `Visit` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Visit` table without a default value. This is not possible if the table is not empty.
  - Made the column `visitId` on table `VitalReading` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('OPEN', 'CLOSED');

-- DropForeignKey
ALTER TABLE "public"."VitalReading" DROP CONSTRAINT "VitalReading_visitId_fkey";

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "branchId" TEXT NOT NULL,
ADD COLUMN     "visitId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "branchId" TEXT NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" "VisitStatus" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "VitalReading" ALTER COLUMN "visitId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VitalReading" ADD CONSTRAINT "VitalReading_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
