import { AuthPageFrame, ResetPasswordForm } from '@/components/auth-forms';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  const validToken =
    typeof token === 'string' && token.length > 0 && token.length <= 2048 ? token : null;
  return (
    <AuthPageFrame title="resetTitle" description="resetDescription">
      <ResetPasswordForm token={validToken} />
    </AuthPageFrame>
  );
}
