import express from "express";
import multer from "multer";
import { createAd, getAds, deleteAd, editAd } from "../controllers/adController.js";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Routes
router.post("/ad", upload.single("photo"), createAd);
router.get("/getAd", getAds);
router.delete("/getAd/:id", deleteAd);
router.put("/getAd/:id", upload.single("photo"), editAd);

export default router;
