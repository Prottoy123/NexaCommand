import fs from "fs";
import { ApiError } from "../utils/ApiError.js";

// Remove any leftover Multer temp files if a request fails before cloud upload
const cleanupRequestTempFiles = (req) => {
  const filesToRemove = [];

  if (req.file?.path) {
    filesToRemove.push(req.file.path);
  }

  if (Array.isArray(req.files)) {
    req.files.forEach((file) => {
      if (file?.path) filesToRemove.push(file.path);
    });
  } else if (req.files && typeof req.files === "object") {
    Object.values(req.files)
      .flat()
      .forEach((file) => {
        if (file?.path) filesToRemove.push(file.path);
      });
  }

  for (const filePath of filesToRemove) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (unlinkError) {
      console.error("Failed to remove temp file:", unlinkError.message);
    }
  }
};

// Global Express error handler (must have 4 parameters: err, req, res, next)
const errorHandler = (err, req, res, next) => {
  // Always clean up local temp files on any error
  cleanupRequestTempFiles(req);

  let error = err;

  // Convert Prisma, Multer, JWT, or unknown errors into ApiError
  if (!(error instanceof ApiError)) {
    let statusCode = error.statusCode || 500;
    let message = error.message || "Internal server error.";

    // Handle known Prisma database errors
    if (error.code === "P2002") {
      // Unique constraint violation
      const targetFields = Array.isArray(error.meta?.target)
        ? error.meta.target.join(", ")
        : "field";
      statusCode = 409;
      message = `Duplicate value detected for unique ${targetFields}.`;
    } else if (error.code === "P2025") {
      // Record not found during update/delete
      statusCode = 404;
      message = "Requested record not found.";
    } else if (error.code === "P2003") {
      // Foreign key constraint violation
      statusCode = 400;
      message = "Invalid reference ID or record is linked to other data.";
    } else if (error.code === "P2023") {
      // Invalid UUID or column data format
      statusCode = 400;
      message = "Invalid ID format provided.";
    } else if (error.name === "PrismaClientValidationError") {
      statusCode = 400;
      message = "Invalid data format sent to database query.";
    }

    // Handle Multer file upload errors
    else if (error.name === "MulterError") {
      statusCode = 400;
      if (error.code === "LIMIT_FILE_SIZE") {
        message = "Uploaded file is too large.";
      } else if (error.code === "LIMIT_UNEXPECTED_FILE") {
        message = "Unexpected file field in upload request.";
      } else {
        message = `File upload error: ${error.message}`;
      }
    }

    // Handle JWT token errors
    else if (error.name === "JsonWebTokenError") {
      statusCode = 401;
      message = "Invalid authentication token.";
    } else if (error.name === "TokenExpiredError") {
      statusCode = 401;
      message = "Authentication token has expired.";
    }

    error = new ApiError(statusCode, message, error.errors || [], error.stack);
  }

  // Send consistent error response payload
  const response = {
    success: false,
    statusCode: error.statusCode,
    message: error.message,
    errors: error.errors || [],
    ...(process.env.NODE_ENV === "development" ? { stack: error.stack } : {}),
  };

  return res.status(error.statusCode).json(response);
};

export { errorHandler };