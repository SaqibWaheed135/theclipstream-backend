import mongoose from "mongoose";

const adSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  adLink: { type: String, required: true },
  category: { type: String },
  displayPhoto: {
    data: Buffer,
    contentType: String,
  },
}, { timestamps: true });

export default mongoose.model("Ad", adSchema);
