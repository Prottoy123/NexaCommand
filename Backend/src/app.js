import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();

// Security & Middleware Configuration
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  }),
);

app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use(express.static("public"));
app.use(cookieParser());

// The Engine Test Route
app.get("/api/v1/healthcheck", (req, res) => {
  res.status(200).json({
    success: true,
    message: "NexaCommand Server Engine is Online and Operational!",
  });
});

export { app };
