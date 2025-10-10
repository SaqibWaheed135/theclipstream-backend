import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    content: { type: String,maxLength: 1000 },
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'file'], default: 'text' },
    fileUrl: { type: String },
    fileSize: { type: Number },
    fileName: { type: String },
    fileType: { type: String }, // New field for MIME type
    key: { type: String },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isDeleted: { type: Boolean, default: false },
    deletedFor: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    editedAt: Date,
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' }
}, { timestamps: true });

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ sender: 1 });
messageSchema.index({ conversation: 1, readBy: 1 });

const Message = mongoose.model('Message', messageSchema);
export default Message;
