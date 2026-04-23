import { Schema, model, Document } from "mongoose";

export interface Package {
  identifier: string;
  priceString: string;
  price: number;
  currencyCode: string;
}  
 
export interface OfferingDocument extends Document {
  identifier: string;
  description: string;
  packages: Package[];
}

const PackageSchema = new Schema<Package>({
  identifier: { type: String, required: true },
  priceString: { type: String, required: true },
  price: { type: Number, required: true },
  currencyCode: { type: String, required: true, default: "USD" },
});

const OfferingSchema = new Schema<OfferingDocument>(
  {
    identifier: { type: String, required: true, unique: true },
    description: { type: String, required: true },
    packages: [PackageSchema],
  },
  { timestamps: true }
);

export default model<OfferingDocument>("Offering", OfferingSchema);
