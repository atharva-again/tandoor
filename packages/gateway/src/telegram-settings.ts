import type { Bot } from "grammy";

/** Clear the private-chat topic settings enabled by previous gateway versions. */
export async function disableTelegramTopics(bot: Bot): Promise<void> {
  const api = bot.api.raw as typeof bot.api.raw & {
    setMySettings(settings: {
      has_topics_enabled: boolean;
      allows_users_to_create_topics: boolean;
      has_topic_sidebar: boolean;
    }): Promise<true>;
  };
  await api.setMySettings({
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    has_topic_sidebar: false,
  });
}
