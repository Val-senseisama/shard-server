import { Schema, model, Types, Document } from "mongoose";

export interface TeamDocument extends Document {
  name: string;
  owner: Types.ObjectId;
  members: Types.ObjectId[]; // includes owner
  chatId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TeamSchema = new Schema<TeamDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 50 },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
    chatId: { type: Schema.Types.ObjectId, ref: "Chat" },
  },
  { timestamps: true }
);

TeamSchema.index({ owner: 1 });
TeamSchema.index({ members: 1 });

export default model<TeamDocument>("Team", TeamSchema);
