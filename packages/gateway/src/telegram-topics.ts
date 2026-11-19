import type { Bot, Context } from "grammy";

export function createdTelegramTopic(ctx: Context): { threadId: number; implicit: boolean } | undefined {
  const message = ctx.message;
  if (!message || !("forum_topic_created" in message)) return undefined;
  const created = message.forum_topic_created;
  return {
    threadId: ("message_thread_id" in message ? message.message_thread_id : undefined) ?? message.message_id,
    implicit: typeof created === "object" && created !== null &&
      "is_name_implicit" in created && created.is_name_implicit === true,
  };
}

/** Bot API's private-topic settings endpoint is newer than the installed Grammy declarations. */
export async function enableTelegramTopics(bot: Bot): Promise<void> {
  const api = bot.api.raw as typeof bot.api.raw & {
    setMySettings(settings: {
      has_topics_enabled: boolean;
      allows_users_to_create_topics: boolean;
      has_topic_sidebar: boolean;
    }): Promise<true>;
  };
  await api.setMySettings({
    has_topics_enabled: true, allows_users_to_create_topics: true, has_topic_sidebar: true,
  });
}
