import { auth, clerkClient } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

// POST /api/puzzles/transfer — hand a puzzle to another Crossword Builder user.
// Body: { id, email }. If an account exists for that email, the puzzle's owner
// (user_id) is reassigned to them: it leaves the sender's list and appears in
// the recipient's, where they become the editor.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, email } = await req.json();
  if (!id || !email || typeof email !== "string") {
    return NextResponse.json(
      { error: "Missing puzzle id or recipient email." },
      { status: 400 }
    );
  }
  const normalized = email.trim().toLowerCase();

  // Find the recipient by email via Clerk.
  let recipientId: string | null = null;
  let recipientEmail = normalized;
  try {
    const client = await clerkClient();
    const list = await client.users.getUserList({ emailAddress: [normalized] });
    const recipient = list.data?.[0];
    if (recipient) {
      recipientId = recipient.id;
      recipientEmail =
        recipient.primaryEmailAddress?.emailAddress ||
        recipient.emailAddresses?.[0]?.emailAddress ||
        normalized;
    }
  } catch {
    return NextResponse.json(
      { error: "Couldn't look up that email. Please try again." },
      { status: 500 }
    );
  }

  if (!recipientId) {
    return NextResponse.json(
      {
        error:
          "No Crossword Builder account uses that email. Ask them to sign up first, then try again.",
      },
      { status: 404 }
    );
  }
  if (recipientId === userId) {
    return NextResponse.json(
      { error: "That's your own account — nothing to transfer." },
      { status: 400 }
    );
  }

  // Reassign ownership — only if the puzzle exists AND belongs to the sender.
  const { data, error } = await supabase
    .from("puzzles")
    .update({ user_id: recipientId, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "Couldn't transfer — the puzzle wasn't found in your account." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, to: recipientEmail });
}
