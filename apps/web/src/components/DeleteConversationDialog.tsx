import { Modal } from "./Modal";

export function DeleteConversationDialog({ title, onCancel, onConfirm }: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="대화를 삭제할까요?" open onClose={onCancel}>
      <p>{title}</p>
      <p>대화 내용과 연결된 작업이 삭제되며, 앱에서 되돌릴 수 없습니다.</p>
      <div className="inline-actions">
        <button type="button" className="secondary" onClick={onCancel} autoFocus>취소</button>
        <button type="button" className="btn-danger-sm" onClick={onConfirm}>삭제</button>
      </div>
    </Modal>
  );
}
