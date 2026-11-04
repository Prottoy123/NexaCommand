import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import ApiError from "../utils/ApiError.js";

// Ensure './public/temp' directory exists to prevent ENOENT server crashes on fresh deployments
const tempDir = "./public/temp";
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Configure disk storage with cryptographic collision-free filenames
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `nexa-${uniqueSuffix}${ext}`);
  },
});

const allowedMimeTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/msword", 
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 
  "text/csv", 
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        400,
        "Unsupported file format! Only Images (JPG, PNG, WEBP) and Official Documents (PDF, DOC, DOCX, XLS, XLSX, CSV) are allowed."
      ),
      false
    );
  }
};

// Export configured multer instance with a 10MB security cap
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max file size
  },
});