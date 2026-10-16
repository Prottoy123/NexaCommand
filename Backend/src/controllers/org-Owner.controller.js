import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();

export const createBranch = asyncHandler(async (req, res) => {
    const { name, location, contactNumber } = req.body;
    
    const tenantId = req.user.tenantId;

    // Validation Check
    if (!name?.trim() || !location?.trim() || !contactNumber?.trim()) {
        throw new ApiError(400, "branch name, location and contact number are required.");
    }

    // Zero-Tolerance Duplication Check
    const existingBranch = await prisma.branch.findFirst({
        where: {
            tenantId,
            name: {
                equals: name.trim(),
                mode: 'insensitive'
            }
        }
    });

    if (existingBranch) {
        throw new ApiError(409, `your branch '${name}' name already exists.`);
    }

    // Database Insertion
    const newBranch = await prisma.branch.create({
        data: {
            tenantId,
            name: name.trim(),
            location: location.trim(),
            contactNumber: contactNumber.trim()
        }
    });

    return res.status(201).json(
        new ApiResponse(201, newBranch, "your branch has been created successfully.")
    );
});

