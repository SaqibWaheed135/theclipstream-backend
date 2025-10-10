import mongoose from 'mongoose';

const groupSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true,
        trim: true,
        maxLength: 100
    },
    description: { 
        type: String, 
        maxLength: 500,
        trim: true
    },
    avatar: { 
        type: String,
        default: null
    },
    type: {
        type: String,
        enum: ['public', 'private'],
        default: 'private'
    },
    admin: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    moderators: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    members: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        joinedAt: {
            type: Date,
            default: Date.now
        },
        role: {
            type: String,
            enum: ['admin', 'moderator', 'member'],
            default: 'member'
        }
    }],
    conversation: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conversation'
    },
    settings: {
        onlyAdminsCanPost: {
            type: Boolean,
            default: false
        },
        onlyAdminsCanEditGroupInfo: {
            type: Boolean,
            default: true
        },
        requireApprovalToJoin: {
            type: Boolean,
            default: false
        }
    },
    pendingRequests: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        requestedAt: {
            type: Date,
            default: Date.now
        }
    }],
    inviteCode: {
        type: String,
        unique: true,
        sparse: true
    }
}, { timestamps: true });

groupSchema.index({ admin: 1 });
groupSchema.index({ 'members.user': 1 });
groupSchema.index({ type: 1 });
groupSchema.index({ inviteCode: 1 });

groupSchema.methods.isMember = function(userId) {
    return this.members.some(m => m.user.toString() === userId.toString());
};

groupSchema.methods.isAdmin = function(userId) {
    return this.admin.toString() === userId.toString();
};

groupSchema.methods.isModerator = function(userId) {
    return this.moderators.some(m => m.toString() === userId.toString()) || 
           this.isAdmin(userId);
};

groupSchema.methods.canPost = function(userId) {
    if (this.settings.onlyAdminsCanPost) {
        return this.isModerator(userId);
    }
    return this.isMember(userId);
};

groupSchema.methods.canEditInfo = function(userId) {
    if (this.settings.onlyAdminsCanEditGroupInfo) {
        return this.isModerator(userId);
    }
    return this.isMember(userId);
};

groupSchema.methods.addMember = function(userId) {
    if (!this.isMember(userId)) {
        this.members.push({
            user: userId,
            joinedAt: new Date(),
            role: 'member'
        });
    }
};

groupSchema.methods.removeMember = function(userId) {
    this.members = this.members.filter(m => m.user.toString() !== userId.toString());
    this.moderators = this.moderators.filter(m => m.toString() !== userId.toString());
};

groupSchema.methods.promoteMember = function(userId) {
    const member = this.members.find(m => m.user.toString() === userId.toString());
    if (member) {
        member.role = 'moderator';
        if (!this.moderators.includes(userId)) {
            this.moderators.push(userId);
        }
    }
};

groupSchema.methods.demoteMember = function(userId) {
    const member = this.members.find(m => m.user.toString() === userId.toString());
    if (member) {
        member.role = 'member';
        this.moderators = this.moderators.filter(m => m.toString() !== userId.toString());
    }
};

const Group = mongoose.model('Group', groupSchema);
export default Group;