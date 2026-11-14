import { AuthPageFrame, EmailRequestForm } from '@/components/auth-forms';

export default function ForgotPasswordPage() {
  return (
    <AuthPageFrame title="forgotTitle" description="forgotDescription">
      <EmailRequestForm kind="reset" />
    </AuthPageFrame>
  );
}
