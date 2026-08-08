import dotenv from "dotenv";
import { app } from "./app.js";

// Load Environment Variables
dotenv.config({
  path: "./.env",
});

const PORT = process.env.PORT || 8000;

// Start Server
app.listen(PORT, () => {
  console.log(`⚙️ NexaCommand Server is running on port: ${PORT}`);
});
