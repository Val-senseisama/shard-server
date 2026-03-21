import SendMail from "./SendMail.js";
import EmailQueue from "../models/EmailQueue.js";

// === Config ===
const BATCH_SIZE = 25;
const SUBJECT = "Important Notification";
const MESSAGE = `You have a new update on Academix, please login to check it out.`;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result = [];
  for (let i = 0; i < arr.length; i += size)
    result.push(arr.slice(i, i + size));
  return result;
}

async function sendBatchNotifications() {
  try {
    // 1. Fetch all unsent notifications with less than 3 attempts
    const emails = await EmailQueue.find({
      status: "pending",
      attempts: { $lt: 3 }
    }).sort({ createdAt: 1 }).lean();

    const successfulIds: string[] = [];
    const failedIds: string[] = [];

    // Process emails in batches
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (email) => {
          try {
            await SendMail({
              recipients: email.toEmail,
              subject: email.subject || SUBJECT,
              message: email.message || MESSAGE,
            });
            successfulIds.push(email._id.toString());
          } catch (err) {
            failedIds.push(email._id.toString());
            console.error(`❌ Failed to send to ${email.toEmail}`, err);
          }
        })
      );

      // Optional: slow down to avoid limits
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 2. Bulk update successful sends
    if (successfulIds.length > 0) {
      await EmailQueue.updateMany(
        { _id: { $in: successfulIds } },
        {
          $set: {
            status: "sent",
            lastAttemptAt: new Date(),
            sentAt: new Date(),
          }
        }
      );
      console.log(`✅ Updated ${successfulIds.length} sent records`);
    }

    // 3. Bulk update failed attempts
    if (failedIds.length > 0) {
      for (const chunk of chunkArray(failedIds, 100)) {
        await EmailQueue.updateMany(
          { _id: { $in: chunk } },
          {
            $set: {
              status: "failed",
              lastAttemptAt: new Date(),
            },
            $inc: { attempts: 1 }
          }
        );
      }
      console.log(`❌ Updated ${failedIds.length} failed records`);
    }

    console.log(`⚠️ Failed: ${failedIds.length} | ✅ Sent: ${successfulIds.length}`);
  } catch (error) {
    console.error("🔥 Error in sendBatchNotifications:", error);
    throw error;
  }
}

// Export the function for use in other modules
export default sendBatchNotifications;
