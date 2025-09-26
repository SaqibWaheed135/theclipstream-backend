import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
  throw new Error("❌ Wasabi credentials are missing. Check your .env file.");
}

const s3 = new AWS.S3({
  accessKeyId: process.env.WASABI_KEY,
  secretAccessKey: process.env.WASABI_SECRET,
  endpoint: new AWS.Endpoint(process.env.WASABI_ENDPOINT), // ✅ FIXED
  region: process.env.WASABI_REGION,
  signatureVersion: "v4",
});

export default s3;
