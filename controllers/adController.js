import Ad from "../models/Ad.js";

// ✅ Create Ad
export const createAd = async (req, res) => {
  try {
    const { title, description, adLink, category } = req.body;

    if (!req.file || !title || !description || !adLink) {
      return res.status(400).json({ success: false, message: "All fields including photo are required" });
    }

    const ad = new Ad({
      title,
      description,
      adLink,
      category,
      displayPhoto: {
        data: req.file.buffer,
        contentType: req.file.mimetype,
      },
    });

    await ad.save();
    res.status(201).json({ success: true, message: "Ad created successfully", data: ad._id });
  } catch (err) {
    console.error("Ad creation error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get All Ads
export const getAds = async (req, res) => {
  try {
    const ads = await Ad.find();

    const formattedAds = ads.map(ad => {
      const adObj = ad.toObject();
      if (adObj.displayPhoto?.data) {
        const base64 = adObj.displayPhoto.data.toString("base64");
        adObj.displayPhoto = `data:${adObj.displayPhoto.contentType};base64,${base64}`;
      } else {
        adObj.displayPhoto = null;
      }
      return adObj;
    });

    res.json({ success: true, data: formattedAds });
  } catch (err) {
    console.error("Error in getAds:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Delete Ad
export const deleteAd = async (req, res) => {
  try {
    await Ad.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Ad deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Update Ad
export const editAd = async (req, res) => {
  try {
    const { title, description, adLink, category } = req.body;
    const updateData = { title, description, adLink, category };

    if (req.file) {
      updateData.displayPhoto = {
        data: req.file.buffer,
        contentType: req.file.mimetype,
      };
    }

    const ad = await Ad.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, data: ad });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
