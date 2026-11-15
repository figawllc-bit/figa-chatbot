// Fixed public test destination/content. No customer data or action buttons.
export const CONNECTION_TEST_USER = 7646333318;
export const CONNECTION_TEST_BOT = 'figa_staff_assistant_bot';
export const CONNECTION_TEST_TEXT = 'FIGA Staff Assistant test: Telegram connection successful.';
export const connectionTestMessage = () => ({
  chat_id: CONNECTION_TEST_USER, text: CONNECTION_TEST_TEXT,
  protect_content: true as const, link_preview_options: { is_disabled: true as const },
});
