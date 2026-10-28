import { NextResponse } from 'next/server';
import { secureRead } from '@/lib/routeSecurity';
import { getMessage } from '@/lib/messages';
import { cancellationDeliveryStatus, CANCELLATION_NOTICE_TYPE } from '@/lib/cancellationNotices';

export const dynamic = 'force-dynamic';
export async function GET(req,{params}) {
  const access=await secureRead(req,'read','READ_CANCELLATION_DELIVERY_STATUS');
  if (!access.ok) return access.response;
  const message=await getMessage(params.messageId);
  if (!message || message.messageType!==CANCELLATION_NOTICE_TYPE) return NextResponse.json({code:'NOTICE_NOT_FOUND',error:'Cancellation notice not found.'},{status:404});
  return NextResponse.json(cancellationDeliveryStatus(message),{headers:{'Cache-Control':'no-store'}});
}
