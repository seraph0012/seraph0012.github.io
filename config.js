// Supabase 项目配置。anon key 按官方设计可安全暴露给客户端，
// 真正的数据安全边界由数据库的 Row Level Security 策略保证，不是靠隐藏这个 key。
// 绝不要把 service role key 放在这里或任何前端代码里。
export const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";
