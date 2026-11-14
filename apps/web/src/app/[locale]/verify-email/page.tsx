import { AuthPageFrame, EmailRequestForm } from '@/components/auth-forms';

export default function VerifyEmailPage() {
  return (
    <AuthPageFrame title="verifyTitle" description="verifyDescription">
      <EmailRequestForm kind="verification" />
    </AuthPageFrame>
  );
}
