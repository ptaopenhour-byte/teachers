// Shared confirmation flow. All ownership, preview and deletion checks run again on the backend.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function confirmAccountDeletion({ email, request, onDeleting = () => {} }) {
    let preview;
    try {
        window.Swal.fire({ title: 'Reviewing account…', allowOutsideClick: false, didOpen: () => window.Swal.showLoading() });
        preview = await request({ action: 'previewAccountDeletion', email });
    } catch (error) {
        await window.Swal.fire({ title: 'Account not deleted', text: error.message, icon: 'warning' });
        return null;
    }
    const s = preview.summary;
    const result = await window.Swal.fire({
        title: 'Permanently delete account?', icon: 'warning',
        html: `<div style="text-align:left;font-size:14px;line-height:1.5;overflow-wrap:anywhere"><p><strong>${escape(email)}</strong></p><div class="account-deletion-summary"><span><strong>${s.children}</strong> children</span><span><strong>${s.guardians}</strong> guardians</span><span><strong>${s.bookings}</strong> bookings</span><span><strong>${s.notifications}</strong> notifications</span></div><p>Deletes this family's profiles, bookings and notifications across all activities, and releases booked time slots.</p><details><summary>Deletion scope &amp; exceptions</summary><p>${s.teacherSchedules} stored teacher schedule(s) will have this family's details removed. Already-sent emails, downloaded exports and backups cannot be recalled. A minimal security marker and untraceable legacy technical references may remain.</p></details><p><strong>This cannot be undone.</strong></p></div>`,
        input: 'text', inputLabel: 'Type the account email to confirm', inputPlaceholder: email,
        inputAttributes: { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Account email confirmation' },
        showCancelButton: true, confirmButtonText: 'Delete account permanently', cancelButtonText: 'Keep account',
        focusCancel: true, showLoaderOnConfirm: true, allowOutsideClick: () => !window.Swal.isLoading(), allowEscapeKey: () => !window.Swal.isLoading(),
        customClass: { popup: 'swal-saas account-danger' },
        preConfirm: async value => {
            if (value.trim() !== email) { window.Swal.showValidationMessage('Enter the exact email shown above.'); return false; }
            onDeleting(true);
            try { return await request({ action: 'deleteAccount', email, confirmationEmail: value.trim(), fingerprint: preview.fingerprint }); }
            catch (error) {
                if(error.code==='ACCOUNT_REVIEW_CHANGED')return {reviewChanged:true};
                window.Swal.showValidationMessage(error.message); return false;
            }
            finally { onDeleting(false); }
        }
    });
    if(result.isConfirmed && result.value?.reviewChanged){
        const again=await window.Swal.fire({title:'Account changed',text:'No data was deleted. Review a fresh summary and type the email again before continuing.',showCancelButton:true,confirmButtonText:'Review updated summary',cancelButtonText:'Keep account',focusCancel:true});
        if(again.isConfirmed)return confirmAccountDeletion({email,request,onDeleting});
        return null;
    }
    return result.isConfirmed ? result.value : null;
}
