import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import dotenv from "dotenv";
import { ApiError } from "./ApiError.js";

dotenv.config({
  path: "./.env",
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadOnCloudinary = async (localFilePath, subFolder = "general") => {
  try {
    if (!localFilePath) return null;

    // Upload the file with dynamic folder structure and resource_type: "auto" for PDF/DOCX/Images
    const response = await cloudinary.uploader.upload(localFilePath, {
      resource_type: "auto",
      folder: `nexacommand/${subFolder}`, // Keeps cloud storage structured by module
    });

    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }

    return response;
  } catch (error) {
    console.error("Cloudinary Upload Error:", error);

    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }
    return null;
  }
};

// Added helper to accurately extract publicId & resourceType from any Cloudinary URL (handles folders & raw files)
export const extractCloudinaryMetadata = (fileUrl) => {
  if (!fileUrl) return { publicId: null, resourceType: "image" };

  try {
    // Detect resource type from URL structure ('raw' for DOCX/XLSX/CSV, 'image' for JPG/PNG/PDF)
    const isRawFile = fileUrl.includes("/raw/upload/");
    const resourceType = isRawFile ? "raw" : "image";

    // Extract everything after '/upload/v123456789/'
    const splitUrl = fileUrl.split("/upload/");
    if (splitUrl.length < 2) return { publicId: null, resourceType };

    const pathAfterVersion = splitUrl[1].replace(/^v\d+\//, "");

    // Critical Cloudinary Rule: 'raw' files require file extension in publicId, 'image' files must strip it
    const publicId = isRawFile
      ? pathAfterVersion
      : pathAfterVersion.substring(0, pathAfterVersion.lastIndexOf(".")) || pathAfterVersion;

    return { publicId, resourceType };
  } catch (error) {
    return { publicId: null, resourceType: "image" };
  }
};

const deleteFromCloudinary = async (publicIdOrUrl, explicitResourceType = null) => {
  try {
    if (!publicIdOrUrl) return null;

    // Automatically parse URL if a full Cloudinary URL is passed instead of just publicId
    let targetPublicId = publicIdOrUrl;
    let targetResourceType = explicitResourceType || "image";

    if (publicIdOrUrl.startsWith("http")) {
      const metadata = extractCloudinaryMetadata(publicIdOrUrl);
      targetPublicId = metadata.publicId;
      targetResourceType = explicitResourceType || metadata.resourceType;
    }

    if (!targetPublicId) return null;

    const response = await cloudinary.uploader.destroy(targetPublicId, {
      resource_type: targetResourceType,
    });

    return response;
  } catch (error) {
    // Log error without throwing 500 so it doesn't mask original DB transaction errors during rollback
    console.error("Cloudinary Rollback/Delete Error:", error);
    return null;
  }
};

export { uploadOnCloudinary, deleteFromCloudinary };